/**
 * DUMP 文本解析工具
 */

function cleanDumpText(text) {
  const lines = text.split('\n');
  const cleaned = [];
  for (const line of lines) {
    // strip trailing spaces, then strip | borders
    let s = line.replace(/\s+$/, '');
    if (s.startsWith('|') && s.endsWith('|')) {
      s = s.slice(1, -1).trim();
    }
    if (s !== '' || (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '')) {
      cleaned.push(s);
    }
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return cleaned.join('\n');
}

function stripPipes(s) {
  if (s.startsWith('|') && s.endsWith('|')) {
    return s.slice(1, -1).trim();
  }
  return s;
}

function parseDumpSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  let bodyLines = [];

  for (const line of lines) {
    let s = line.replace(/\s+$/, '');
    // separator line: all dashes
    if (s && /^-{10,}$/.test(s)) {
      if (current) {
        // clean body lines: strip pipes
        const cleanedBody = bodyLines.map(stripPipes).join('\n').replace(/\s+$/, '')
          .replace(/\n{3,}/g, '\n\n');
        if (cleanedBody) current.body = cleanedBody;
        sections.push(current);
      }
      current = null;
      bodyLines = [];
      continue;
    }
    if (!s && bodyLines.length === 0) continue;
    if (current === null) {
      current = { title: stripPipes(s) };
    } else {
      bodyLines.push(s);
    }
  }
  if (current) {
    const cleanedBody = bodyLines.map(stripPipes).join('\n').replace(/\s+$/, '')
      .replace(/\n{3,}/g, '\n\n');
    if (cleanedBody) current.body = cleanedBody;
    sections.push(current);
  }
  return sections;
}

module.exports = { cleanDumpText, stripPipes, parseDumpSections };
