function tokenError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function rotateCheckinToken(tokens, appointmentId, token, expiresAt, now) {
  const remaining = tokens.filter((record) => record.appointmentId !== appointmentId);
  return [
    ...remaining,
    {
      id: token,
      appointmentId,
      active: true,
      createdAt: now,
      expiresAt,
      usedAt: null,
    },
  ];
}

export function redeemCheckinToken(tokens, tokenId, now) {
  const current = tokens.find((record) => record.id === tokenId);
  if (!current) throw tokenError("TOKEN_NOT_FOUND");
  if (!current.active || current.usedAt) throw tokenError("TOKEN_INACTIVE");
  if (current.expiresAt < now) throw tokenError("TOKEN_EXPIRED");

  return tokens.map((record) =>
    record.id === tokenId ? { ...record, active: false, usedAt: now } : record,
  );
}
