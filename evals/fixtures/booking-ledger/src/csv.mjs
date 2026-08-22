function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportAppointments(rows) {
  const lines = ["id,customer,status"];
  for (const row of rows) {
    lines.push([row.id, row.customer, row.status].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
