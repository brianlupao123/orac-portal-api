import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function metadata(content) {
  const fields = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\*\*(Status|Owner|Approver|Version):\*\*\s*(.+)$/);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  return fields;
}

export function approvedKnowledgeArticles(baseDirectory) {
  return readdirSync(baseDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({ name: entry.name, ...metadata(readFileSync(join(baseDirectory, entry.name), "utf8")) }))
    .filter((article) => article.status === "Approved" && article.owner && article.approver && article.version);
}
