import { esc } from './utils.js';

function mdInline(raw) {
  let value = esc(String(raw || ''));
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  value = value.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<em>$2</em>');
  return value;
}

function mdTextBlock(raw) {
  const lines = String(raw || '').split('\n'); let html = '', list = '';
  const closeList = () => { if (list) { html += `</${list}>`; list = ''; } };
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(x => mdInline(x.trim()));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]; if (!line.trim()) { closeList(); continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      closeList(); const headers = cells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i += 1; }
      i -= 1; html += `<div class="md-table-wrap"><table><thead><tr>${headers.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/); if (heading) { closeList(); const n = heading[1].length + 2; html += `<h${n}>${mdInline(heading[2])}</h${n}>`; continue; }
    const quote = line.match(/^>\s?(.+)$/); if (quote) { closeList(); html += `<blockquote>${mdInline(quote[1])}</blockquote>`; continue; }
    if (/^[-*_]{3,}$/.test(line.trim())) { closeList(); html += '<hr>'; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.+)$/); if (ul) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += `<li>${mdInline(ul[1])}</li>`; continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/); if (ol) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += `<li>${mdInline(ol[1])}</li>`; continue; }
    closeList(); html += `<p>${mdInline(line)}</p>`;
  }
  closeList(); return html;
}
export function renderMarkdown(markdown) {
  const source = String(markdown || '').replace(/\r\n?/g, '\n');
  let html = '', cursor = 0;
  const fence = /```([\w.+-]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(source))) {
    html += mdTextBlock(source.slice(cursor, match.index));
    const language = esc(match[1] || 'code');
    html += `<div class="md-code"><div class="md-code-head"><span>${language}</span><button type="button" data-copy-code>Копировать</button></div><pre><code>${esc(match[2].replace(/\n$/, ''))}</code></pre></div>`;
    cursor = match.index + match[0].length;
  }
  html += mdTextBlock(source.slice(cursor));
  return html || '<p>Пустой ответ.</p>';
}
