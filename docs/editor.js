// A small code editor: a textarea laid over a highlighted copy of its own text.
// No dependency. The textarea holds the text and the caret; the <pre> under it draws
// the colours. Both sit in one grid cell, so they always have the same size and the
// surrounding box scrolls them together.

const SQL_WORDS = new Set(
  `select from where group by having order limit offset join left right full inner outer cross on using as and or not
   in exists between like ilike is null distinct union all except intersect with recursive case when then else end over
   partition rows range preceding following current row unbounded insert into values update set delete merge matched
   create table view replace drop alter add column primary key references default cast interval date timestamp time
   true false asc desc nulls first last qualify filter within lateral asof window any some returning temporary temp
   integer bigint smallint double decimal numeric varchar text boolean`
    .split(/\s+/)
    .filter(Boolean)
);

const PY_WORDS = new Set(
  `def return if elif else for while in not and or is None True False import from as with try except finally raise class
   lambda yield pass break continue global nonlocal assert del async await match case`
    .split(/\s+/)
    .filter(Boolean)
);

const SQL_TOKENS = /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
const PY_TOKENS = /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|()\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

const escapeHtml = (text) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// Returns HTML for code in "sql" or "python"; anything else is escaped and left plain.
export function highlight(code, language) {
  const tokens = language === "sql" ? SQL_TOKENS : language === "python" ? PY_TOKENS : null;
  if (!tokens) return escapeHtml(code);
  const words = language === "sql" ? SQL_WORDS : PY_WORDS;
  let html = "";
  let last = 0;
  tokens.lastIndex = 0;
  for (let m = tokens.exec(code); m; m = tokens.exec(code)) {
    if (m[0] === "") {
      tokens.lastIndex++;
      continue;
    }
    html += escapeHtml(code.slice(last, m.index));
    const text = escapeHtml(m[0]);
    if (m[1] !== undefined) html += `<span class="t-c">${text}</span>`;
    else if (m[2] !== undefined) html += `<span class="t-s">${text}</span>`;
    else if (m[3]) html += `<span class="t-i">${text}</span>`;
    else if (m[4] !== undefined) html += `<span class="t-n">${text}</span>`;
    else if (words.has(language === "sql" ? m[5].toLowerCase() : m[5])) html += `<span class="t-k">${text}</span>`;
    else html += text;
    last = m.index + m[0].length;
  }
  return html + escapeHtml(code.slice(last));
}

function insert(textarea, text) {
  // execCommand keeps the browser's undo history; setRangeText is the fallback.
  textarea.focus();
  if (!document.execCommand || !document.execCommand("insertText", false, text)) {
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function lineRange(textarea) {
  const value = textarea.value;
  const start = value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
  let end = value.indexOf("\n", Math.max(textarea.selectionEnd - (textarea.selectionEnd > textarea.selectionStart ? 1 : 0), start));
  if (end === -1) end = value.length;
  return { start, end };
}

function replaceLines(textarea, change) {
  const { start, end } = lineRange(textarea);
  const before = textarea.value.slice(start, end);
  const after = before.split("\n").map(change).join("\n");
  textarea.setSelectionRange(start, end);
  insert(textarea, after);
  textarea.setSelectionRange(start, start + after.length);
}

// createEditor(host, { value, language, label, minLines, onInput, onSubmit, onRun })
// returns { value (get/set), focus(), element }.
export function createEditor(host, options) {
  const language = options.language;
  const unit = language === "python" ? "    " : "  ";
  const comment = language === "python" ? "# " : "-- ";
  host.innerHTML = `
    <div class="ed" data-language="${language}">
      <div class="ed-scroll">
        <div class="ed-gutter" aria-hidden="true"></div>
        <div class="ed-stack">
          <pre class="ed-paint" aria-hidden="true"></pre>
          <textarea class="ed-text" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off" aria-label="${options.label}"></textarea>
        </div>
      </div>
    </div>`;
  const textarea = host.querySelector(".ed-text");
  const paint = host.querySelector(".ed-paint");
  const gutter = host.querySelector(".ed-gutter");
  const minLines = options.minLines || 8;
  let leaveOnTab = false;

  function draw() {
    const value = textarea.value;
    // The trailing space gives a final empty line its height.
    paint.innerHTML = highlight(value, language) + " ";
    const lines = Math.max(value.split("\n").length, minLines);
    if (gutter.childElementCount !== lines) {
      gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<span>${i + 1}</span>`).join("");
    }
    paint.style.minHeight = `calc(${lines} * var(--ed-line))`;
  }

  textarea.value = options.value;
  draw();

  textarea.addEventListener("input", () => {
    draw();
    if (options.onInput) options.onInput(textarea.value);
  });

  textarea.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && mod) {
      event.preventDefault();
      if (event.shiftKey && options.onRun) options.onRun();
      else if (options.onSubmit) options.onSubmit();
    } else if (event.key === "/" && mod) {
      event.preventDefault();
      const { start, end } = lineRange(textarea);
      const lines = textarea.value.slice(start, end).split("\n").filter((l) => l.trim());
      const allCommented = lines.length > 0 && lines.every((l) => l.trimStart().startsWith(comment.trim()));
      replaceLines(textarea, (line) => {
        if (!line.trim()) return line;
        const indent = line.match(/^\s*/)[0];
        const rest = line.slice(indent.length);
        if (allCommented) return indent + rest.replace(new RegExp(`^${comment.trim()} ?`), "");
        return indent + comment + rest;
      });
    } else if (event.key === "Escape") {
      leaveOnTab = true; // Esc then Tab moves focus out, so the editor is not a keyboard trap
    } else if (event.key === "Tab" && !mod && !event.altKey) {
      if (leaveOnTab) {
        leaveOnTab = false;
        return;
      }
      event.preventDefault();
      const multi = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).includes("\n");
      if (event.shiftKey) replaceLines(textarea, (line) => (line.startsWith(unit) ? line.slice(unit.length) : line.replace(/^ +/, "")));
      else if (multi) replaceLines(textarea, (line) => (line ? unit + line : line));
      else insert(textarea, unit);
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      const { start } = lineRange(textarea);
      const line = textarea.value.slice(start, textarea.selectionStart);
      let indent = line.match(/^ */)[0];
      if (language === "python" && /:\s*$/.test(line)) indent += unit;
      if (indent) {
        event.preventDefault();
        insert(textarea, "\n" + indent);
      }
    }
    if (event.key !== "Escape") leaveOnTab = false;
  });

  return {
    element: host.querySelector(".ed"),
    get value() {
      return textarea.value;
    },
    set value(next) {
      textarea.value = next;
      draw();
    },
    focus() {
      textarea.focus();
    },
  };
}
