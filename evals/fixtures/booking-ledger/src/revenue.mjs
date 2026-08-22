export function summarizeRevenue(orders) {
  const paid = orders.filter((order) => order.status === "paid");
  return {
    paidOrders: paid.length,
    netCents: paid.reduce((sum, order) => sum + order.amountCents, 0),
  };
}
