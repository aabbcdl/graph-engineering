export function listAppointments(records, tenantId) {
  return records
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .filter((record) => !record.deletedAt);
}
