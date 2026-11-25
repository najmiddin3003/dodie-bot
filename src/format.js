// Markdown -> Telegram HTML (b, i, s, code, pre, a). Brauzerda ham ishlaydi (panel uchun).

// Hamma kod bitta funksiya ichida — panelga matn sifatida ham uzatiladi (fayl o'qimasdan).
function formatLib() {
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(text) {
    const codes = [];
    text = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    text = escapeHtml(text);
    text = text.replace(/^(\s*)[*-]\s+/gm, "$1• ");
    text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
    text = text.replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`,
    );
    text = text.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>").replace(/__([^\n]+?)__/g, "<b>$1</b>");
    text = text.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, "$1<i>$2</i>");
    text = text.replace(/(^|[^\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, "$1<i>$2</i>");
    text = text.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[i])}</code>`);
  }

  function toTelegramHtml(md) {
    let out = "";
    let last = 0;
    for (const m of md.matchAll(/```([\w+#-]*)[^\n]*\n?([\s\S]*?)```/g)) {
      out += inline(md.slice(last, m.index));
      const code = escapeHtml(m[2].replace(/\n$/, ""));
      out += m[1] ? `<pre><code class="language-${m[1]}">${code}</code></pre>` : `<pre>${code}</pre>`;
      last = m.index + m[0].length;
    }
    return out + inline(md.slice(last));
  }

  /** Telegram 4096 belgi chegarasi uchun matnni bo'laklarga ajratish. */
  function splitMessage(text, max = 3500) {
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf("\n\n", max);
      if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
      if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
      if (cut <= 0) cut = max;
      chunks.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  return { escapeHtml, toTelegramHtml, splitMessage };
}

export const { escapeHtml, toTelegramHtml, splitMessage } = formatLib();

/** Brauzer uchun: panel sahifasiga qo'yiladigan manba kod. */
export const FORMAT_LIB_SOURCE = `const { escapeHtml, toTelegramHtml, splitMessage } = (${formatLib.toString()})();`;
