export function exportCsv(rows) {
  const header = "name,city";
  const body = rows.map((row) => `${row.name},${row.city}`).join("\n");
  return `${header}\n${body}`;
}
