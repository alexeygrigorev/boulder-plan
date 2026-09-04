// Очень маленький markdown → HTML (bold, links, lists, headers #/##).
// Достаточно для текстов плана; без зависимостей.
export function md(body: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(doc:([A-Za-z0-9_]+)\)/g, '<button class="doclink" data-doc="$2">$1</button>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = body.split("\n");
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      closeList();
      html += `<h4>${inline(line.replace(/^###\s+/, ""))}</h4>`;
    } else if (/^##\s+/.test(line)) {
      closeList();
      html += `<h3>${inline(line.replace(/^##\s+/, ""))}</h3>`;
    } else if (/^-\s+\[ \]/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(line.replace(/^-\s+\[ \]\s*/, ""))}</li>`;
    } else if (/^-\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(line.replace(/^-\s+/, ""))}</li>`;
    } else if (/^\d+\.\s+/.test(line)) {
      closeList();
      html += `<p>${inline(line)}</p>`;
    } else if (line.trim() === "") {
      closeList();
    } else if (/^>\s?/.test(line)) {
      closeList();
      html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`;
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}
